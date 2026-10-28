import { z } from 'zod';
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
export const EnvReferencesSchema = z.record(envName, envName);
export function processEnvironment(privateRefs: Record<string,string> = {}, publicRefs: Record<string,string> = {}, host: NodeJS.ProcessEnv = process.env): { env: Record<string,string>; secrets: string[] } {
  const allowed = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR)$/i;
  const env: Record<string,string> = Object.fromEntries(Object.entries(host).filter(([key,value])=>allowed.test(key)&&value!==undefined).map(([key,value])=>[key,value!]));
  const secrets: string[] = [], targets = new Set<string>();
  for (const [refs, sensitive] of [[privateRefs,true],[publicRefs,false]] as const) for (const [target, source] of Object.entries(refs)) {
    const key = target.toUpperCase();
    if (key === 'NODE_OPTIONS' || targets.has(key)) throw new Error('source_env_target_invalid');
    targets.add(key);
    if (!host[source]) throw new Error('source_env_missing:' + source);
    env[target] = host[source]!;
    if (sensitive) secrets.push(host[source]!);
  }
  return { env, secrets };
}
