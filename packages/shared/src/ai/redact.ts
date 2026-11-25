/**
 * Contact details out of a person's own text before it is sent to a model:
 * a business description can carry an email address or a phone number, and
 * DeepSeek's API keeps what it is sent in China (NDPA, CMP-11). Names and
 * places are left: the model needs them to suggest a name, and a business's
 * name or town is not what this guards.
 */

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu
// Seven or more digits, allowing a leading +, spaces, dots, dashes and brackets between them.
const PHONE = /\+?\(?\d(?:[\s().-]*\d){6,}/g

export function redactContactDetails(text: string): string {
  return text.replace(EMAIL, '[email]').replace(PHONE, '[phone]')
}
