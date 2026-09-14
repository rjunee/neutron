/** Whether a value is explicit enough to be a git rev-range operand. */
export function isQualifiedRevRangeOperand(value, objectNameWidths = [40, 64]) {
  if (typeof value !== 'string') return false
  if (value.startsWith('refs/')) return true
  return objectNameWidths.some(
    (width) => Number.isInteger(width) && width > 0 && value.length === width && /^[0-9a-f]+$/i.test(value),
  )
}

if (import.meta.main) {
  const [value, ...widthArgs] = process.argv.slice(2)
  const widths = widthArgs.map(Number)
  process.exit(isQualifiedRevRangeOperand(value, widths.length > 0 ? widths : undefined) ? 0 : 1)
}
