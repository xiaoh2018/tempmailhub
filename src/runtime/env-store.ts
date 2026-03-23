type RuntimeBindings = Record<string, unknown>;

let runtimeBindings: RuntimeBindings = {};

export function setRuntimeBindings(bindings?: RuntimeBindings): void {
  if (!bindings || typeof bindings !== 'object') {
    return;
  }

  runtimeBindings = {
    ...runtimeBindings,
    ...bindings
  };
}

export function getRuntimeEnv(name: string): string | undefined {
  const bindingValue = runtimeBindings[name];
  if (bindingValue !== undefined && bindingValue !== null && String(bindingValue).trim()) {
    return String(bindingValue).trim();
  }

  try {
    if (typeof globalThis !== 'undefined' && (globalThis as any).Deno?.env) {
      const value = (globalThis as any).Deno.env.get(name);
      if (value && String(value).trim()) {
        return String(value).trim();
      }
    }
  } catch (error) {
    console.warn(`Failed to read Deno env ${name}:`, error);
  }

  try {
    if (typeof globalThis !== 'undefined' && (globalThis as any).process?.env) {
      const value = (globalThis as any).process.env[name];
      if (value && String(value).trim()) {
        return String(value).trim();
      }
    }
  } catch (error) {
    console.warn(`Failed to read process env ${name}:`, error);
  }

  return undefined;
}
