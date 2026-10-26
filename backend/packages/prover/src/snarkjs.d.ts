declare module "snarkjs" {
  export const groth16: {
    fullProve(input: unknown, wasm: string, zkey: string): Promise<{ proof: any; publicSignals: string[] }>;
    verify(vkey: unknown, publicSignals: string[], proof: unknown): Promise<boolean>;
  };
}
