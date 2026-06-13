// Heuristics for deciding whether a file is binary and should be skipped
// during text indexing. Pure functions with no I/O.

// Number of leading bytes inspected when sniffing buffer content.
const SAMPLE_SIZE = 8000;

// Control characters above this ratio (excluding tab/newline/carriage-return)
// strongly indicate a binary payload.
const CONTROL_CHAR_RATIO_THRESHOLD = 0.3;

// File extensions (lowercase, without leading dot) that are always treated as
// binary blobs and never indexed as text.
export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set<string>([
  // Images
  'png',
  'jpg',
  'jpeg',
  'gif',
  'bmp',
  'tiff',
  'tif',
  'ico',
  'webp',
  'heic',
  'heif',
  'psd',
  'svgz',
  // Audio
  'mp3',
  'wav',
  'flac',
  'aac',
  'ogg',
  'oga',
  'm4a',
  'wma',
  'opus',
  'mid',
  'midi',
  // Video
  'mp4',
  'm4v',
  'mkv',
  'mov',
  'avi',
  'wmv',
  'flv',
  'webm',
  'mpg',
  'mpeg',
  // Archives / compressed
  'zip',
  'tar',
  'gz',
  'tgz',
  'bz2',
  'xz',
  '7z',
  'rar',
  'zst',
  'lz',
  'lzma',
  'cab',
  'jar',
  'war',
  // Executables / libraries / objects
  'exe',
  'dll',
  'so',
  'dylib',
  'bin',
  'o',
  'obj',
  'a',
  'lib',
  'class',
  'pyc',
  'pyo',
  'wasm',
  'msi',
  'apk',
  'app',
  'deb',
  'rpm',
  'dmg',
  'iso',
  'img',
  // Fonts
  'ttf',
  'otf',
  'woff',
  'woff2',
  'eot',
  // MU / game binary blobs and similar opaque assets
  'ozt',
  'ozj',
  'ozb',
  'ozg',
  'ozd',
  'ozp',
  'bmd',
  'tga',
  'dds',
  'pak',
  'dat',
  // Office documents
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'odt',
  'ods',
  'odp',
  // Documents / databases
  'pdf',
  'sqlite',
  'sqlite3',
  'db',
  'mdb',
]);

// Detect a binary buffer by sampling its leading bytes.
// Rules: any NUL byte (0x00) => binary; otherwise a high ratio of control
// characters (excluding \t, \n, \r) => binary.
export function isBinaryBuffer(buf: Buffer): boolean {
  const length = Math.min(buf.length, SAMPLE_SIZE);
  if (length === 0) {
    return false;
  }

  let controlCount = 0;
  for (let i = 0; i < length; i++) {
    const byte = buf[i];
    if (byte === undefined) {
      continue;
    }
    if (byte === 0x00) {
      return true;
    }
    // Count C0 control chars except tab (0x09), newline (0x0a),
    // carriage return (0x0d). Also count DEL (0x7f).
    const isAllowedWhitespace = byte === 0x09 || byte === 0x0a || byte === 0x0d;
    if ((byte < 0x20 && !isAllowedWhitespace) || byte === 0x7f) {
      controlCount++;
    }
  }

  return controlCount / length > CONTROL_CHAR_RATIO_THRESHOLD;
}

// Decide if an extension is a known binary type. Accepts either "png" or
// ".png"; matching is case-insensitive.
export function isLikelyBinaryByExtension(ext: string): boolean {
  const normalized = ext.replace(/^\.+/, '').toLowerCase();
  if (normalized === '') {
    return false;
  }
  return BINARY_EXTENSIONS.has(normalized);
}
