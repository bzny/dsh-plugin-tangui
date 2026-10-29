// Optional test-only resolution of the real DSH SDK already installed locally.
// No mock exports, source rewriting, global installation, or application startup.
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

if (process.env.DSH_HOST_MODULES) {
  const hostParent = pathToFileURL(resolve(process.env.DSH_HOST_MODULES, '../package.json')).href;
  registerHooks({ resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !['@deepseek-ai/', '@earendil-works/'].some(prefix => specifier.startsWith(prefix))) throw error;
      return nextResolve(specifier, { ...context, parentURL: hostParent });
    }
  } });
}
