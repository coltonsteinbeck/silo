export const managedPolicyFixture = {
  personaId: 'caretaker',
  textProvider: 'openai',
  textModel: 'example-text-model',
  promptVersion: 'v1',
  prompt: 'Be a helpful caretaker.',
  customPromptsDisabled: true,
  assistantOutputBlockedMessage: 'Try a safe alternative.',
  allowMildAssistantProfanity: true,
  assistantSafetyPolicy: 'contextual_banter',
  alternatePersonaEnabled: true,
  defaultAliases: ['Caretaker'],
  alternateAliases: ['Dr. Bird'],
  turnInstructions: {
    default: 'Answer clearly.',
    alternate: 'Use a fictional title.',
    ordinary: 'Be concise.',
    contextual_explanation: 'Explain factually.',
    boundary_redirect: 'Offer a safe alternative.'
  }
};
