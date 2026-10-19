import { describe, it, expect } from 'vitest';
import { classify, plan, select } from '../src/router.js';
import { defaults, validateConfig, requireConfigured } from '../src/config.js';
import type { Model } from '../src/types.js';
const cfg = { ...structuredClone(defaults), models: { fast: 'p/fast', balanced: 'p/balanced', deep: 'p/deep' } };
const catalog: Model[] = ['fast', 'balanced', 'deep'].map(t => ({ id: `p/${t}`, tools: true, context: 64000 }));
describe('router', () => {
  it.each(['Encuentra dónde se calcula la conversión', 'Explain the parser', 'Busca la función'])('read-only fast: %s', text => {
    const c = classify(text), stages = plan(c); expect(stages).toHaveLength(1); expect(select('t', stages[0]!, c, cfg, catalog).tier).toBe('fast');
  });
  it('keeps sensitive searches read-only', () => { expect(plan(classify('Encuentra la autenticación')).map(s => s.kind)).toEqual(['explore']); });
  it('omits planning for trivial edits', () => { expect(plan(classify('Corrige una errata en README')).map(s => s.kind)).toEqual(['implement']); });
  it('uses mixed tiers for complex tasks', () => {
    const c = classify('Migra múltiples módulos'); expect(plan(c).map(s => select('t', s, c, cfg, catalog).tier)).toEqual(['fast', 'deep', 'balanced', 'balanced']);
  });
  it.each([
    'Implementa un test del reloj. Solicita permiso OpenCode antes de editar.',
    'Implementa un test del reloj. Solicita permisos antes de editar.',
    'Implementa un test del reloj. Respeta los permisos de OpenCode.',
    'Implement a clock test. Request permission before editing.',
    'Corrige el parser. No modifiques permisos ni autenticación.',
    'Fix the parser. Do not change authentication or permissions.',
  ])('does not escalate for operational guard instructions: %s', request => {
    const c = classify(request);
    expect(c.sensitive).toBe(false);
    expect(c.reasons).toContain('OPERATIONAL_GUARD_IGNORED');
    expect(plan(c).map(s => s.kind)).toEqual(['explore', 'implement', 'validate']);
  });
  it.each([
    'Modifica los permisos de administración',
    'Implementa pagos. Solicita permiso antes de editar.',
    'Request permission to delete database records',
    'Corrige el checkout. No modifiques autenticación.',
    'No cambies permisos excepto para el administrador',
    'No cambies permisos sin modificar autenticación',
    'Do not change permissions except for admins',
    'No cambies permisos y elimina autenticación',
    'No cambies estilos, implementa pagos',
    'No cambies estilos: implementa autenticación',
    'No cambies estilos — implementa permisos',
    'Do not modify comments, remove authentication',
    'Modifica los permisos de OpenCode',
    'Solicita permisos de administrador',
    'No cambies permisos, excepto para el administrador',
    'Do not change permissions, except for admins',
  ])('keeps sensitive work and ambiguous exceptions conservative: %s', request => {
    expect(classify(request).sensitive).toBe(true);
  });
  it('keeps a read-only request read-only when writes are explicitly prohibited', () => {
    const c = classify('Explica cómo funciona el parser. No modifiques archivos.');
    expect(c.kind).toBe('read'); expect(plan(c)).toHaveLength(1);
  });
  it('uses deep decisions and review for sensitive changes', () => {
    const c = classify('Refactoriza el checkout'); const stages = plan(c);
    expect(stages).toHaveLength(5); expect(select('t', stages[1]!, c, cfg, catalog).tier).toBe('deep'); expect(select('t', stages[4]!, c, cfg, catalog).tier).toBe('deep');
  });
  it('prioritizes manual override over escalation', () => {
    const c = classify('Implementa feature'); const s = plan(c)[0]!;
    expect(select('t', s, c, cfg, catalog, 'fast', 'deep')).toMatchObject({ tier: 'fast', modelId: 'p/fast', isOverride: true });
    expect(select('t', s, c, cfg, catalog, 'p/deep').modelId).toBe('p/deep');
  });
  it('rejects models without tools and insufficient context', () => {
    const c = classify('Busca parser'), s = plan(c)[0]!;
    expect(() => select('t', s, c, cfg, [{ ...catalog[0]!, tools: false }])).toThrow('Incompatible');
    expect(() => select('t', s, c, cfg, [{ ...catalog[0]!, context: 100 }])).toThrow('Incompatible');
  });
  it('never silently substitutes an unknown model', () => {
    const c = classify('Busca parser'), s = plan(c)[0]!;
    expect(() => select('t', s, c, cfg, [])).toThrow('unavailable');
    const d = select('t', s, c, { ...cfg, fallbacks: { fast: 'p/deep' } }, [catalog[2]!]); expect(d.reasonCodes).toContain('DECLARED_FALLBACK');
  });
  it('falls back conservatively for ambiguity without another billed call', () => { expect(classify('haz lo necesario')).toMatchObject({ kind: 'complex', confidence: 'low' }); });
  it('does not use prompt length as complexity', () => { expect(classify(`Encuentra función ${'detail '.repeat(1000)}`).kind).toBe('read'); });
});
describe('configuration', () => {
  it('ships safe placeholders', () => { expect(() => requireConfigured(defaults)).toThrow('placeholders'); });
  it.each([-1, Infinity, NaN, '2'])('rejects invalid budget %s', budget => { const c = structuredClone(defaults); (c.limits as any).maxCostUsd = budget; expect(() => validateConfig(c)).toThrow(); });
  it('rejects fractional request limits', () => { const c = structuredClone(defaults); c.limits.maxModelCalls = 1.5; expect(() => validateConfig(c)).toThrow(); });
});

describe('benchmark classification regressions',()=>{
  it.each(['Migra múltiples módulos. Usa read para explorar.', 'Edita solution.js. Usa read para explorar.', 'Implement the change after you read the file.'])('keeps action requests actionable: %s',request=>{
    expect(classify(request).kind).not.toBe('read');
    expect(plan(classify(request)).map(s=>s.kind)).toContain('implement');
  });
  it('retains planning for a migration with read instructions',()=>{
    expect(plan(classify('Migra múltiples módulos. Usa read para explorar.')).map(s=>s.kind)).toEqual(['explore','plan','implement','validate']);
  });
});

describe('read intent around complex terminology',()=>{
  it.each(['Explica la arquitectura', 'Encuentra la documentación de migración', 'Explain the editor', 'Explain the migration plan'])('keeps explanatory tasks read only: %s',request=>{
    expect(classify(request).kind).toBe('read');
    expect(plan(classify(request)).map(s=>s.kind)).toEqual(['explore']);
  });
});


describe('sensitive identifiers and credential terminology',()=>{
  it.each(['Implementa redactSecrets recursivo: password, token y apiKey.', 'Implementa validación de APIKey', 'Implementa validación de api_key', 'Actualiza credentials handling', 'Cambia la contraseña', 'Refactor sanitizePii'])('requires deep review for %s',request=>{
    const c=classify(request);expect(c.sensitive).toBe(true);
    const stages=plan(c);expect(stages.map(s=>s.kind)).toContain('review');
    expect(select('t',stages.find(s=>s.kind==='review')!,c,cfg,catalog).tier).toBe('deep');
  });
  it('does not mistake token usage accounting for access credentials',()=>{
    expect(classify('Añade contadores de tokens y coste').sensitive).toBe(false);
  });
  it('retains ignored operational guards around sensitive filenames',()=>{
    expect(classify('Corrige errata del README. No modifiques apiKey ni credentials.').sensitive).toBe(false);
  });
});
