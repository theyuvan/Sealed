"use client";
import { motion, type HTMLMotionProps } from "motion/react";
import { ReactNode } from "react";

const ease = [0.2, 0.8, 0.2, 1] as const;

// Fades and slides up when scrolled into view.
export function Reveal({ children, delay = 0, y = 32, className = "" }: { children: ReactNode; delay?: number; y?: number; className?: string }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.7, delay, ease }}
    >
      {children}
    </motion.div>
  );
}

// Parent that staggers its <Item> children.
export function Stagger({ children, className = "", gap = 0.12, inView = true }: { children: ReactNode; className?: string; gap?: number; inView?: boolean }) {
  const variants = { hidden: {}, show: { transition: { staggerChildren: gap, delayChildren: 0.1 } } };
  const props = inView
    ? { initial: "hidden", whileInView: "show", viewport: { once: true, margin: "-80px" } }
    : { initial: "hidden", animate: "show" };
  return <motion.div className={className} variants={variants} {...props}>{children}</motion.div>;
}

export function Item({ children, className = "", ...rest }: { children: ReactNode; className?: string } & HTMLMotionProps<"div">) {
  return (
    <motion.div
      className={className}
      variants={{ hidden: { opacity: 0, y: 28 }, show: { opacity: 1, y: 0, transition: { duration: 0.65, ease } } }}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

// Drifting ticker word for the dark band.
export function Floaty({ children, className = "", i = 0 }: { children: ReactNode; className?: string; i?: number }) {
  return (
    <motion.span
      className={className}
      initial={{ opacity: 0 }}
      whileInView={{ opacity: 1 }}
      viewport={{ once: true }}
      transition={{ duration: 0.8, delay: i * 0.1 }}
    >
      <motion.span
        className="inline-block"
        animate={{ y: [0, -10, 0], x: [0, i % 2 ? 6 : -6, 0] }}
        transition={{ duration: 4 + (i % 3), repeat: Infinity, ease: "easeInOut", delay: i * 0.3 }}
      >
        {children}
      </motion.span>
    </motion.span>
  );
}

export { motion };
