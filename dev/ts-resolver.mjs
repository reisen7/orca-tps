// Resolver hook: try `./x.ts` when `./x` is not found, the way Orca resolves plugin imports.
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context)
  } catch (error) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
      return next(`${specifier}.ts`, context)
    }
    throw error
  }
}
