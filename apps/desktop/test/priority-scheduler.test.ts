import { describe, expect, it } from 'vitest';
import { PriorityScheduler } from '../src/priority-scheduler';

describe('priority scheduler', () => {
  it('does not erase history eligibility when the current transport slice yields before admission',()=>{
    const scheduler=new PriorityScheduler(4);scheduler.committed('realtime',4);scheduler.committed('history',0);
    expect(scheduler.next(20,20)).toBe('history');scheduler.committed('history',1);expect(scheduler.next(20,20)).toBe('realtime');
  });
  it('gives realtime work four batches before one history batch', () => {
    const scheduler = new PriorityScheduler(4);
    const queues = Array.from({ length: 5 }, () => { const queue = scheduler.next(10, 10)!; scheduler.committed(queue, 1); return queue; });
    expect(queues).toEqual(['realtime', 'realtime', 'realtime', 'realtime', 'history']);
    expect(scheduler.next(10, 10)).toBe('realtime');
  });
  it('drains whichever queue is available and does not spin when empty', () => {
    const scheduler = new PriorityScheduler();
    expect(scheduler.next(0, 3)).toBe('history'); expect(scheduler.next(3, 0)).toBe('realtime'); expect(scheduler.next(0, 0)).toBeUndefined();
  });
});
