// A thinking reserve is not a universal minimum output length.
// Only a verified boolean thinking switch proves that the reserve is unnecessary.
export function completionBudgetEligible(body, model, config, reasoningLevel) {
  const requested = Number(body.max_completion_tokens || body.max_tokens || 0);
  const minimum = Number(model.minimumCompletionTokensForReliableAnswer || 0);
  if (!(requested > 0 && minimum > 0 && requested < minimum)) return true;
  const control = model.reasoningControl;
  if (!control?.verified || control.parameter !== 'chat_template_kwargs.enable_thinking' || control.values?.off !== false) return false;
  const explicit = body.chat_template_kwargs?.enable_thinking;
  if (explicit !== undefined) return explicit === false;
  return config.reasoningControl?.enabled === true && reasoningLevel === 'off';
}
