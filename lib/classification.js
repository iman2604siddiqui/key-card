const sensitivePatterns = [
  [/salary|compensation|payroll|payslip|wage|bonus|salary adjustment|benefit dispute|tax deduction/i, 'sensitive · compensation / benefits'],
  [/visa|immigration|work authorization|sponsor/i, 'sensitive · immigration'],
  [/harass|discriminat|conduct complaint|hostile workplace/i, 'sensitive · workplace conduct'],
  [/accommodation|disability|medical adjustment/i, 'sensitive · accommodation'],
  [/terminat|disciplin|fire me|resign/i, 'sensitive · employment action'],
  [/legal dispute|lawyer|lawsuit/i, 'sensitive · legal'],
  [/exception|waive|override|make an exception/i, 'policy exception'],
  [/confidential personnel|private employee|someone else.*record/i, 'confidential personnel information']
];

export function classifySensitive(question) {
  for (const [pattern, reason] of sensitivePatterns) if (pattern.test(question)) return { escalate: true, reason, category: 'sensitive' };
  return null;
}
