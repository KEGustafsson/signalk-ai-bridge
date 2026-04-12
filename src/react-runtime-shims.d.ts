declare module 'react' {
  export type ReactNode = unknown;

  export interface JSXElementConstructor<P> {
    (props: P): unknown;
  }

  export const StrictMode: (props: { children?: unknown }) => unknown;

  export function useState<T>(initial: T): [T, (value: T | ((prev: T) => T)) => void];
  export function useEffect(effect: () => void | (() => void), deps: readonly unknown[]): void;
  export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
  export function useCallback<T extends (...args: never[]) => unknown>(
    callback: T,
    deps: readonly unknown[]
  ): T;
}

declare module 'react-dom/client' {
  export interface Root {
    render(node: unknown): void;
  }

  export function createRoot(container: Element): Root;
}

declare namespace JSX {
  interface IntrinsicElements {
    [elemName: string]: unknown;
  }
}


declare module 'react/jsx-runtime' {
  export const jsx: (...args: unknown[]) => unknown;
  export const jsxs: (...args: unknown[]) => unknown;
  export const Fragment: unknown;
}

declare module 'vite' {
  export function defineConfig(config: unknown): unknown;
}
