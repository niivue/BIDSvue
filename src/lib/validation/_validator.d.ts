// Ambient module declarations for the deep validator imports used by
// _validatorEntry.ts. At runtime these are resolved by esbuild's
// `alias` config (scripts/bundle-validator.ts) and inlined into the
// generated bundle. TypeScript / svelte-check don't see esbuild's
// aliases though, so we declare the modules as `any` here to short-
// circuit module resolution -- the actual type surface is in
// _validatorEntry.ts (hand-written ValidationResult / Issue / ...
// types that callers consume).

declare module '@bids/validator/internal/validators/bids.js' {
  // biome-ignore lint/suspicious/noExplicitAny: see file comment
  export const validate: any
}

declare module '@bids/validator/internal/files/browser.js' {
  // biome-ignore lint/suspicious/noExplicitAny: see file comment
  export const fileListToTree: any
}

declare module '@bids/validator/internal/files/filetree.js' {
  // biome-ignore lint/suspicious/noExplicitAny: see file comment
  export const filesToTree: any
}

declare module '@bids/validator/internal/files/ignore.js' {
  // biome-ignore lint/suspicious/noExplicitAny: see file comment
  export const FileIgnoreRules: any
  // biome-ignore lint/suspicious/noExplicitAny: see file comment
  export const readBidsIgnore: any
}

declare module '@bids/validator/internal/types/filetree.js' {
  // biome-ignore lint/suspicious/noExplicitAny: see file comment
  export const BIDSFile: any
  // biome-ignore lint/suspicious/noExplicitAny: see file comment
  export const FileTree: any
}
