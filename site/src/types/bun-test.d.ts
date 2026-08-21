/**
 * Minimal typings for `bun:test`, covering what our unit tests use. The full
 * `@types/bun` package replaces ambient Node/DOM types project-wide (breaking
 * the Next.js server code), so the tests get this narrow shim instead.
 */
declare module "bun:test" {
  export function describe(label: string, fn: () => void): void;
  export interface TestFn {
    (label: string, fn: () => void | Promise<void>, timeoutMs?: number): void;
    skipIf(condition: boolean): TestFn;
  }
  export const test: TestFn;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export interface Matchers {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toBeCloseTo(expected: number, precision?: number): void;
    toBeGreaterThan(expected: number): void;
    toBeGreaterThanOrEqual(expected: number): void;
    toBeLessThan(expected: number): void;
    toBeLessThanOrEqual(expected: number): void;
    toContain(expected: string): void;
    toBeUndefined(): void;
    toBeNull(): void;
    toHaveLength(expected: number): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    not: Matchers;
  }
  export function expect(value: unknown): Matchers;
  /** Module mocking, for the tests that stand a dependency in. */
  export const mock: {
    module(specifier: string, factory: () => unknown): void;
  };
}
