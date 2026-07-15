export function chooseFoodCourtGlm(
  recentLegacyMape: number | null,
  recentGlmMape: number | null,
  fullLegacyMape: number | null,
  fullGlmMape: number | null,
): boolean {
  const legacy = recentLegacyMape ?? fullLegacyMape
  const glm = recentGlmMape ?? fullGlmMape
  return glm != null && (legacy == null || glm < legacy)
}
