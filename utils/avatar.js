// A properly resized 256x256 JPEG data URL typically comes out to 50-150KB of base64 —
// 300,000 characters is generous headroom over that, enough to catch a client that
// skipped the resize step (a modified client, a bug) without rejecting real photos.
const MAX_AVATAR_BASE64_LENGTH = 300_000;

// Throws if a client-supplied avatar value is unreasonably large or the wrong type.
// null/undefined both pass through untouched — both are valid "no avatar" / "don't
// touch it" signals to the callers of this function, not error cases.
export function validateAvatarBase64(value) {
  if (value == null) return;
  if (typeof value !== 'string') {
    throw new Error('avatarBase64 must be a string or null');
  }
  if (value.length > MAX_AVATAR_BASE64_LENGTH) {
    throw new Error(
      `avatarBase64 is too large (${value.length} characters, max ${MAX_AVATAR_BASE64_LENGTH})`,
    );
  }
}

const MAX_NAME_LENGTH = 200;

// Throws if a display name is missing, all-whitespace, or unreasonably long. Returns the
// trimmed value — callers should store/use the RETURN value, not their original input,
// so " Alice " isn't persisted with stray whitespace and "   " doesn't pass as non-empty.
export function validateDisplayName(name) {
  if (typeof name !== 'string') {
    throw new Error('name must be a string');
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error('name cannot be empty');
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new Error(`name is too long (${trimmed.length} characters, max ${MAX_NAME_LENGTH})`);
  }
  return trimmed;
}
