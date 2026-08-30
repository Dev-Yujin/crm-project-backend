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
