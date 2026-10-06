/** Who someone is, in words: their name, else their address (MAIL-SPEC §10 Settings). */
export function memberName(member: { name: string | null; email: string | null }): string {
  return member.name ?? member.email ?? 'A member'
}
