// `bun build --compile` understands `import x from "...node" with {type:"file"}`
// and returns the runtime path; tsc has no idea about either. Shim it.
declare module "@snazzah/davey-linux-x64-gnu/davey.linux-x64-gnu.node" {
  const path: string;
  export default path;
}
