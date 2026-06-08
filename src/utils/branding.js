const CONTACT_INFO = "mandrykinsergey@gmail.com | twitch.tv/dnovitv";

// Legacy alias — kept for backward compat
export const FORGETMEAI_WATERMARK = CONTACT_INFO;
export { CONTACT_INFO };

export function printContactInfo() {
  console.log(`\n${CONTACT_INFO}\n`);
}

export function formatContactInfo(prefix = "Contact") {
  return `${prefix}: ${CONTACT_INFO}`;
}
