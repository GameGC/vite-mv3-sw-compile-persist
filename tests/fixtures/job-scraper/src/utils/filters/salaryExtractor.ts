export function extractSalary(text: string): number | null {
  const match = text.match(/\$?([0-9,]+)/);
  if (!match) return null;
  return parseInt(match[1].replace(/,/g, ''), 10);
}

export function formatSalary(salary: number): string {
  return `$${salary.toLocaleString()}`;
}
