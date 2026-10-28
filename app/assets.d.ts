// Stylesheets are imported as text (`with {type: 'text'}`) and served by the Worker.
declare module '*.css' {
  const source: string
  export default source
}
