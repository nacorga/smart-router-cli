import { tiers, type Classification, type Config, type Decision, type Model, type Stage, type Tier } from './types.js';
/** Ignore narrow operational guard clauses, keeping exceptions and ambiguous scope conservative. */
function classificationText(text: string): { text: string; ignoredGuard: boolean } {
  let ignoredGuard = false;
  const identifiers = text.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const normalized = identifiers.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  const guarded = normalized.replace(
    /\b(?:no|do not|don't)\s+(?:modifi\w*|cambi\w*|toqu\w*|edit\w*|borr\w*|elimin\w*|delet\w*|touch|change|modify|remove)\b[^,.;:!\n—–-]*/g,
    (clause, offset: number) => {
      // Exceptions, positive conjunctions and conditions can still request sensitive changes.
      const suffix = normalized.slice(offset + clause.length);
      if (/^[\s,.;:!—–-]*(?:excepto|except|salvo|unless|pero|but|sin|without)\b/.test(suffix)) return clause;
      if (/\b(pero|but|excepto|except|salvo|unless|sin|without|y|and|then|despues)\b/.test(clause)) return clause;
      ignoredGuard = true;
      return ' ';
    },
  );
  const operational = guarded.replace(
    /\b(?:solicita\w*|pide|pedir|request(?:s)?|require(?:s)?|ask(?:s)? for)\s+(?:(?:el|un|the|explicit|human|explicito|humano)\s+)*(?:permisos?|permissions?|approval|autorizacion)\b(?=\s*(?:(?:open\s*code|humano|human)\b\s*)?(?:(?:antes de|before|para\s+(?:editar|escribir|ejecutar)|to\s+(?:edit|write|run))\b|[.;,!]|$))/g,
    () => { ignoredGuard = true; return ' '; },
  );
  const respected = operational.replace(/\b(?:respeta|respect|follow|obey)\s+(?:(?:los|the)\s+)?(?:permisos|permissions)\s+(?:de\s+)?open\s*code\b/g, () => { ignoredGuard = true; return ' '; });
  return { text: respected, ignoredGuard };
}
export function classify(text: string): Classification {
  const input = classificationText(text);
  const s = input.text;
  const sensitive = /\b(auth\w*|autentic\w*|permis\w*|pago\w*|payment\w*|checkout|secret\w*|credencial\w*|credential\w*|password\w*|contrasen\w*|api[ _-]?keys?|access[ _-]?tokens?|bearer|pii|borr\w*|delet\w*|datos|database)\b/.test(s);
  const complex = /\b(arquitect\w*|architect\w*|migra\w*|multiples? modulos|multiple modules|transversal|redisen\w*|redesign)\b/.test(s);
  const change = /\b(implement\w*|edit(?:a|ar|ing|s|ed)?|migra(?:r|s|n|mos)?|migrate(?:s|d)?|migrating|crea\w*|create|add|anad\w*|refactor\w*|fix\w*|corrig\w*|repara\w*|modific\w*|cambia\w*|actualiz\w*)\b/.test(s);
  const read = /\b(busca\w*|encuentra\w*|explica\w*|resume\w*|localiza\w*|donde|what|where|find|explain|read|summari\w*)\b/.test(s);
  const simple = change && /\b(typo|errata|comentario|comment|readme|ortograf\w*)\b/.test(s) && !complex && !sensitive;
  const known = complex || change || read || sensitive;
  return { kind: read && !change ? 'read' : complex ? 'complex' : simple ? 'simple' : change || sensitive ? 'change' : read ? 'read' : 'complex', sensitive, confidence: known ? 'high' : 'low', reasons: [sensitive ? 'SENSITIVE' : 'NORMAL_RISK', known ? 'DETERMINISTIC_RULE' : 'AMBIGUOUS_CONSERVATIVE', ...(input.ignoredGuard ? ['OPERATIONAL_GUARD_IGNORED'] : [])] };
}
export function plan(c: Classification): Stage[] {
  const kinds = c.kind === 'read' ? ['explore'] : c.kind === 'simple' ? ['implement'] : ['explore', ...(c.kind === 'complex' || c.sensitive ? ['plan'] : []), 'implement', 'validate', ...(c.sensitive ? ['review'] : [])];
  return kinds.map((kind, i) => ({ id: `${i + 1}`, kind: kind as Stage['kind'], status: 'pending', decisions: [] }));
}
/** Planned target only; capability/availability checks still happen in select. */
export function routeTarget(stage: Stage, c: Classification, config: Config, override?: string, escalated?: Tier): { tier: Tier; modelId: string } {
  let tier: Tier = stage.kind === 'explore' ? 'fast' : stage.kind === 'plan' || stage.kind === 'review' || (stage.kind === 'validate' && c.sensitive) ? 'deep' : c.kind === 'simple' ? 'fast' : 'balanced';
  if (escalated) tier = escalated;
  if (override && tiers.includes(override as Tier)) tier = override as Tier;
  return { tier, modelId: override && !tiers.includes(override as Tier) ? override : config.models[tier] };
}
export function select(taskId: string, stage: Stage, c: Classification, config: Config, catalog: Model[], override?: string, escalated?: Tier): Decision {
  const { tier, modelId: target } = routeTarget(stage, c, config, override, escalated);
  let modelId = target;
  let model = catalog.find(m => m.id === modelId);
  const reasons = [...c.reasons, `STAGE_${stage.kind.toUpperCase()}`, ...(override ? ['MANUAL_OVERRIDE'] : []), ...(escalated ? ['REPRODUCIBLE_VALIDATION_FAILURE'] : [])];
  if (!model && !override && config.fallbacks?.[tier]) { modelId = config.fallbacks[tier]!; model = catalog.find(m => m.id === modelId); reasons.push('DECLARED_FALLBACK'); }
  if (!model) throw new Error(`Model unavailable: ${modelId}`);
  if (!model.tools || model.context < config.minContext) throw new Error(`Incompatible model (tools/context): ${modelId}`);
  const estimatedCostUsd = model.inputPrice !== undefined && model.outputPrice !== undefined ? (8000 * model.inputPrice + 2000 * model.outputPrice) / 1e6 : undefined;
  return { taskId, stepId: stage.id, tier, modelId, reasonCodes: reasons, confidence: c.confidence, isOverride: !!override, estimatedCostUsd, timestamp: new Date().toISOString() };
}
export function nextTier(tier: Tier): Tier | undefined { return tiers[tiers.indexOf(tier) + 1]; }
