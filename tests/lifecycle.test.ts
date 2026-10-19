import { describe, expect, it } from 'vitest';
import { interruptedReservation } from '../src/lifecycle-spike.js';
import type { Model, Task } from '../src/types.js';
const catalog: Model[] = [{ id:'p/balanced', tools:true, context:1000000, outputLimit:500000, inputPrice:0.3, outputPrice:1.2 }];
const task = { unknownCost:true, usage:[{ messageId:'m', inputTokens:0, outputTokens:0, source:'unknown', modelId:'p/balanced' }] } as Task;
describe('interrupted request budget reservation', () => {
  it('reserves full catalog input and output limits while preserving unknown actual cost', () => {
    const reservation = interruptedReservation(task,catalog);
    expect(reservation.reservedCostUsd).toBeCloseTo(0.9);
    expect(task.unknownCost).toBe(true); expect(task.usage[0]!.costUsd).toBeUndefined();
  });
  it('does not reserve again for reported usage', () => {
    expect(interruptedReservation({...task,unknownCost:false,usage:[{...task.usage[0]!,costUsd:0.01,source:'backend'}]},catalog).reservedCostUsd).toBe(0);
  });
  it('blocks when a missing cost cannot be bounded from available catalog data', () => {
    expect(()=>interruptedReservation(task,[{...catalog[0]!,outputLimit:undefined}])).toThrow('NO_CATALOG_LIMITS');
    expect(()=>interruptedReservation({...task,usage:[]},catalog)).toThrow('NO_IDENTIFIABLE');
  });
});
