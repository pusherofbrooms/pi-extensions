const stubs = new Map([
  ["@mariozechner/pi-coding-agent", `export class UserMessageComponent { constructor(text) { this.text = text; } }`],
  ["@mariozechner/pi-ai", `export function StringEnum(values) { return { values }; }`],
  ["typebox", `
    const make = (name) => (...args) => ({ name, args });
    export const Type = {
      Object: make("Object"), Array: make("Array"), String: make("String"), Number: make("Number"),
      Boolean: make("Boolean"), Optional: make("Optional"),
    };
  `],
  ["./agent-runner.ts", `
    export async function runAgentSession() {
      throw new Error("Tests must inject GoalRuntimeDeps.runAgent.");
    }
  `],
]);

export async function resolve(specifier, context, nextResolve) {
  if (stubs.has(specifier)) {
    return { url: `data:text/javascript,${encodeURIComponent(stubs.get(specifier))}`, shortCircuit: true };
  }
  if (specifier.endsWith("/agent-runner.ts")) {
    const source = stubs.get("./agent-runner.ts");
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
