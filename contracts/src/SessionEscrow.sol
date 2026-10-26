// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MandateRegistry} from "./MandateRegistry.sol";

interface ISpendVerifier {
    function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[12] calldata pub)
        external
        view
        returns (bool);
}

interface IERC3009 {
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}

/// @title SessionEscrow
/// @notice A valid spend proof opens a session capped at the negotiated price. HSP funds it with an
///         EIP-3009 transfer (nonce = sessionId). The seller is paid the latest cumulative voucher
///         signed by the session key bound in the proof; the rest goes back to the buyer.
contract SessionEscrow is EIP712, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Opened,
        Funded,
        Closed,
        Refunded
    }

    struct Session {
        address buyer;
        address seller;
        address token;
        address sessionKey;
        uint128 cap;
        uint128 funded;
        uint64 deadline;
        Status status;
        bytes32 cartHash;
        bytes32 hspOrderId;
        uint256 nullifier;
    }

    struct Voucher {
        bytes32 sessionId;
        uint128 cumulativeAmount;
        uint32 callCount;
        bytes32 deliveryHashChain;
    }

    // public signal indices (circuits/spend.circom)
    uint256 internal constant P_ROOT = 0;
    uint256 internal constant P_NULLIFIER = 1;
    uint256 internal constant P_NEW_COMMITMENT = 2;
    uint256 internal constant P_REV_TAG = 3;
    uint256 internal constant P_AMOUNT = 4;
    uint256 internal constant P_SELLER = 6;
    uint256 internal constant P_TOKEN = 7;
    uint256 internal constant P_CART_HASH = 8;
    uint256 internal constant P_SESSION_ID = 9;
    uint256 internal constant P_NOW = 10;
    uint256 internal constant P_SESSION_KEY = 11;

    uint256 public constant SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 public constant MAX_CLOCK_SKEW = 300;
    uint256 public constant MAX_SESSION_DURATION = 7 days;
    bytes32 public constant VOUCHER_TYPEHASH =
        keccak256("Voucher(bytes32 sessionId,uint128 cumulativeAmount,uint32 callCount,bytes32 deliveryHashChain)");

    ISpendVerifier public immutable verifier;
    MandateRegistry public immutable registry;
    address public coordinator;

    mapping(address => bool) public tokenAllowed;
    mapping(bytes32 => Session) internal _sessions;
    /// @notice per token: sum of `funded` over sessions in status Funded
    mapping(address => uint256) public locked;

    event SessionOpened(bytes32 indexed sessionId, uint256 nullifier, address seller, uint128 cap, bytes32 cartHash);
    event SessionFunded(bytes32 indexed sessionId, bytes32 hspOrderId);
    event Receipt(
        bytes32 indexed sessionId,
        uint256 nullifier,
        bytes32 hspOrderId,
        uint128 paid,
        uint128 refunded,
        bytes32 deliveryHashChain
    );
    event TokenAllowed(address token, bool allowed);
    event CoordinatorSet(address coordinator);

    error InvalidProof();
    error UnknownRoot();
    error NullifierSpent();
    error MandateRevoked();
    error TokenNotAllowed();
    error StaleProof();
    error BadDeadline();
    error SignalMismatch(uint256 index);
    error BadAmount();
    error SessionExists();
    error WrongStatus();
    error NotCoordinator();
    error NotSeller();
    error NotAuthorized();
    error InsufficientEscrowBalance();
    error BadVoucher();
    error OverCap();
    error DeadlineNotPassed();
    error DeadlinePassed();

    modifier onlyCoordinator() {
        if (msg.sender != coordinator) revert NotCoordinator();
        _;
    }

    constructor(ISpendVerifier verifier_, MandateRegistry registry_, address coordinator_, address owner_)
        EIP712("SealedSessionEscrow", "1")
        Ownable(owner_)
    {
        verifier = verifier_;
        registry = registry_;
        coordinator = coordinator_;
        emit CoordinatorSet(coordinator_);
    }

    // ------------------------------------------------------------------ admin

    function setTokenAllowed(address token, bool allowed) external onlyOwner {
        tokenAllowed[token] = allowed;
        emit TokenAllowed(token, allowed);
    }

    function setCoordinator(address coordinator_) external onlyOwner {
        coordinator = coordinator_;
        emit CoordinatorSet(coordinator_);
    }

    // ------------------------------------------------------------------ views

    function getSession(bytes32 sessionId) external view returns (Session memory) {
        return _sessions[sessionId];
    }

    /// @notice sessionId = keccak(chainid, escrow, nullifier, buyer, seller, deadline). Buyer and deadline
    ///         are included so a front-runner cannot reuse a proof with different values.
    function computeSessionId(uint256 nullifier, address buyer, address seller, uint64 deadline)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(block.chainid, address(this), nullifier, buyer, seller, deadline));
    }

    function voucherDigest(Voucher calldata v) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(VOUCHER_TYPEHASH, v.sessionId, v.cumulativeAmount, v.callCount, v.deliveryHashChain))
        );
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ------------------------------------------------------------------ open

    function open(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[12] calldata pub,
        address buyer,
        address seller,
        uint64 deadline,
        bytes32 cartHash
    ) external nonReentrant returns (bytes32 sessionId) {
        _checkSignals(pub, seller, deadline, cartHash);

        sessionId = computeSessionId(pub[P_NULLIFIER], buyer, seller, deadline);
        if (uint256(sessionId) % SNARK_FIELD != pub[P_SESSION_ID]) revert SignalMismatch(P_SESSION_ID);
        if (_sessions[sessionId].status != Status.None) revert SessionExists();

        if (!verifier.verifyProof(a, b, c, pub)) revert InvalidProof();

        // effects
        uint128 cap = uint128(pub[P_AMOUNT]);
        _sessions[sessionId] = Session({
            buyer: buyer,
            seller: seller,
            token: address(uint160(pub[P_TOKEN])),
            sessionKey: address(uint160(pub[P_SESSION_KEY])),
            cap: cap,
            funded: 0,
            deadline: deadline,
            status: Status.Opened,
            cartHash: cartHash,
            hspOrderId: bytes32(0),
            nullifier: pub[P_NULLIFIER]
        });
        registry.consume(pub[P_NULLIFIER], pub[P_NEW_COMMITMENT]);

        emit SessionOpened(sessionId, pub[P_NULLIFIER], seller, cap, cartHash);
    }

    function _checkSignals(uint256[12] calldata pub, address seller, uint64 deadline, bytes32 cartHash) internal view {
        if (!registry.isKnownRoot(pub[P_ROOT])) revert UnknownRoot();
        if (registry.isSpent(pub[P_NULLIFIER])) revert NullifierSpent();
        if (registry.isRevoked(pub[P_REV_TAG])) revert MandateRevoked();

        uint256 amount = pub[P_AMOUNT];
        if (amount == 0 || amount > type(uint128).max) revert BadAmount();
        if (pub[P_SELLER] != uint256(uint160(seller)) || seller == address(0)) revert SignalMismatch(P_SELLER);
        if (pub[P_TOKEN] >> 160 != 0 || !tokenAllowed[address(uint160(pub[P_TOKEN]))]) revert TokenNotAllowed();
        if (pub[P_SESSION_KEY] >> 160 != 0 || pub[P_SESSION_KEY] == 0) revert SignalMismatch(P_SESSION_KEY);
        if (uint256(cartHash) % SNARK_FIELD != pub[P_CART_HASH]) revert SignalMismatch(P_CART_HASH);

        uint256 t = pub[P_NOW];
        uint256 skew = t > block.timestamp ? t - block.timestamp : block.timestamp - t;
        if (skew > MAX_CLOCK_SKEW) revert StaleProof();
        if (deadline <= block.timestamp || deadline > block.timestamp + MAX_SESSION_DURATION) revert BadDeadline();
    }

    // ------------------------------------------------------------------ fund

    /// @notice Called by the settlement coordinator once HSP reports the payment and the chain shows
    ///         the EIP-3009 transfer with nonce = sessionId.
    function markFunded(bytes32 sessionId, bytes32 hspOrderId) external onlyCoordinator nonReentrant {
        Session storage s = _sessions[sessionId];
        if (s.status != Status.Opened) revert WrongStatus();
        if (block.timestamp > s.deadline) revert DeadlinePassed();
        if (!IERC3009(s.token).authorizationState(s.buyer, sessionId)) revert NotAuthorized();
        if (IERC20(s.token).balanceOf(address(this)) < locked[s.token] + s.cap) revert InsufficientEscrowBalance();

        s.funded = s.cap;
        s.status = Status.Funded;
        s.hspOrderId = hspOrderId;
        locked[s.token] += s.cap;
        emit SessionFunded(sessionId, hspOrderId);
    }

    // ------------------------------------------------------------------ close

    /// @notice Seller claims the latest voucher. Only the seller may close before the deadline, so the
    ///         buyer cannot settle with an older, smaller voucher.
    function close(bytes32 sessionId, Voucher calldata v, bytes calldata buyerSig) external nonReentrant {
        Session storage s = _sessions[sessionId];
        if (s.status != Status.Funded) revert WrongStatus();
        if (msg.sender != s.seller) revert NotSeller();
        _settle(sessionId, s, v, buyerSig, false);
    }

    /// @notice After the deadline anyone can close: with the last voucher, or with none (callCount 0,
    ///         empty signature) to refund everything. Unfunded sessions are refunded if HSP's transfer
    ///         arrived but was never marked.
    function closeAfterDeadline(bytes32 sessionId, Voucher calldata v, bytes calldata buyerSig) external nonReentrant {
        Session storage s = _sessions[sessionId];
        if (block.timestamp <= s.deadline) revert DeadlineNotPassed();

        if (s.status == Status.Opened) {
            uint128 refund;
            if (
                IERC3009(s.token).authorizationState(s.buyer, sessionId)
                    && IERC20(s.token).balanceOf(address(this)) >= locked[s.token] + s.cap
            ) refund = s.cap;
            s.status = Status.Refunded;
            emit Receipt(sessionId, s.nullifier, s.hspOrderId, 0, refund, bytes32(0));
            if (refund > 0) IERC20(s.token).safeTransfer(s.buyer, refund);
            return;
        }
        if (s.status != Status.Funded) revert WrongStatus();
        _settle(sessionId, s, v, buyerSig, buyerSig.length == 0 && v.callCount == 0 && v.cumulativeAmount == 0);
    }

    function _settle(bytes32 sessionId, Session storage s, Voucher calldata v, bytes calldata sig, bool noVoucher)
        internal
    {
        uint128 paid;
        bytes32 chain;
        if (!noVoucher) {
            if (v.sessionId != sessionId) revert BadVoucher();
            (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(voucherDigest(v), sig);
            if (err != ECDSA.RecoverError.NoError || signer != s.sessionKey) revert BadVoucher();
            if (v.cumulativeAmount > s.funded) revert OverCap();
            paid = v.cumulativeAmount;
            chain = v.deliveryHashChain;
        }
        uint128 refunded = s.funded - paid;

        s.status = Status.Closed;
        locked[s.token] -= s.funded;
        emit Receipt(sessionId, s.nullifier, s.hspOrderId, paid, refunded, chain);

        if (paid > 0) IERC20(s.token).safeTransfer(s.seller, paid);
        if (refunded > 0) IERC20(s.token).safeTransfer(s.buyer, refunded);
    }
}
