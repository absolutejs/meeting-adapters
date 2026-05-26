// prism-media ships no type declarations for its deep subpaths. We import the
// Opus decoder directly from this subpath (instead of the package index) so
// prism's FFmpeg module — which does a literal `require('ffmpeg-static')` — is
// never pulled into the bundle. Declared `any`; the consumer casts to the
// decoder shape it uses.
declare module "prism-media/src/opus/Opus";
