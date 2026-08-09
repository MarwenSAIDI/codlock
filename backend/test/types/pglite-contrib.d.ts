/**
 * PGlite ships its contrib extensions behind `exports` subpaths, which the
 * project's `moduleResolution: node` cannot see. Node resolves the subpath
 * fine at runtime; this declaration just gives TypeScript the shape, so the
 * main tsconfig does not have to change resolution mode for a test-only dep.
 */
declare module '@electric-sql/pglite/contrib/pgcrypto' {
  import type { Extension } from '@electric-sql/pglite';
  export const pgcrypto: Extension;
}
