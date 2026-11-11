// SPDX-License-Identifier: BSD-3-Clause

/** Handle target-counter, target-counters and target-text (mirrors css/targets.py). */
import { LOGGER } from '../logger.ts';
import { getUrlTuple } from '../urls.ts';

export class TargetLookupItem {
  state: string;
  targetBox: any = null;
  parseAgainFunctions = new Map<any, Map<string, () => void>>();
  pageMakerIndex: number | null = null;
  cachedPageCounterValues: Record<string, number[]> = {};
  constructor(state = 'pending') {
    this.state = state;
  }
}

export class CounterLookupItem {
  parseAgain: (mixin?: any) => void;
  missingCounters: string[];
  missingTargetCounters: Record<string, string[]>;
  pageMakerIndex: number | null = null;
  pending = false;
  cachedPageCounterValues: Record<string, number[]> = {};
  constructor(parseAgain: (mixin?: any) => void, missingCounters: string[], missingTargetCounters: Record<string, string[]>) {
    this.parseAgain = parseAgain;
    this.missingCounters = missingCounters;
    this.missingTargetCounters = missingTargetCounters;
  }
}

export function anchorNameFromToken(token: any[]): string | undefined {
  if (token[0] === 'string' && token[1].startsWith('#')) return token[1].slice(1);
  if (token[0] === 'url' && token[1][0] === 'internal') return token[1][1];
  return undefined;
}

export class TargetCollector {
  targetLookupItems = new Map<string, TargetLookupItem>();
  counterLookupItems = new Map<any, Map<string, CounterLookupItem>>();
  collecting = true;
  hadPendingTargets = false;

  /**
   * Return to the state right after style computation (anchors known, nothing
   * looked up yet). renderDocument lays the document out again whenever images
   * were missing; each pass must start from scratch, as upstream's single
   * synchronous pass does, or stale boxes and cached page counters from the
   * discarded pass leak into the next one.
   */
  reset(): void {
    for (const item of this.targetLookupItems.values()) {
      item.state = 'pending';
      item.targetBox = null;
      item.parseAgainFunctions = new Map();
      item.pageMakerIndex = null;
      item.cachedPageCounterValues = {};
    }
    this.counterLookupItems = new Map();
    this.collecting = true;
    this.hadPendingTargets = false;
  }

  collectAnchor(anchorName: unknown): void {
    if (typeof anchorName === 'string') {
      if (this.targetLookupItems.get(anchorName) !== undefined) LOGGER.warning(`Anchor defined twice: '${anchorName}'`);
      else if (!this.targetLookupItems.has(anchorName)) this.targetLookupItems.set(anchorName, new TargetLookupItem());
    }
  }

  lookupTarget(anchorToken: any[], sourceBox: any, cssToken: string, parseAgain: () => void): TargetLookupItem {
    if (anchorToken[0] === 'attr()') {
      const [attrName, type, fallback] = anchorToken[1];
      const attrValue = sourceBox.element.get(attrName, fallback);
      if (type === 'string') anchorToken = ['string', attrValue];
      else if (type === 'url') anchorToken = ['url', getUrlTuple(attrValue, sourceBox.style.baseUrl)];
    }
    const anchorName = anchorNameFromToken(anchorToken);
    const item = (anchorName !== undefined ? this.targetLookupItems.get(anchorName) : undefined) ?? new TargetLookupItem('undefined');
    if (item.state === 'pending') {
      this.hadPendingTargets = true;
      let m = item.parseAgainFunctions.get(sourceBox);
      if (!m) item.parseAgainFunctions.set(sourceBox, (m = new Map()));
      if (!m.has(cssToken)) m.set(cssToken, parseAgain);
    }
    if (item.state === 'undefined') LOGGER.error(`Content discarded: target points to undefined anchor ${JSON.stringify(anchorToken)}`);
    return item;
  }

  storeTarget(anchorName: string, targetCounterValues: Map<string, number[]>, targetBox: any): void {
    const item = this.targetLookupItems.get(anchorName);
    if (item && item.state === 'pending') {
      item.state = 'up-to-date';
      item.targetBox = targetBox;
      if (targetBox.cachedCounterValues === null) {
        targetBox.cachedCounterValues = new Map([...targetCounterValues].map(([k, v]) => [k, v.slice()]));
      }
    }
  }

  collectMissingCounters(
    parentBox: any, cssToken: string, parseAgain: (m?: any) => void, missingCounters: string[],
    missingTargetCounters: Record<string, string[]>,
  ): void {
    if (!this.collecting) return;
    if (missingCounters.length || Object.keys(missingTargetCounters).length) {
      if (parentBox.missingLink === null) parentBox.missingLink = parentBox;
      let m = this.counterLookupItems.get(parentBox);
      if (!m) this.counterLookupItems.set(parentBox, (m = new Map()));
      if (!m.has(cssToken)) m.set(cssToken, new CounterLookupItem(parseAgain, missingCounters, missingTargetCounters));
    }
  }

  checkPendingTargets(): void {
    if (this.hadPendingTargets) {
      for (const item of this.targetLookupItems.values()) {
        for (const m of item.parseAgainFunctions.values()) for (const fn of m.values()) fn();
      }
      this.hadPendingTargets = false;
    }
    this.collecting = false;
  }

  cacheTargetPageCounters(anchorName: string, pageCounterValues: Record<string, number[]>, pageMakerIndex: number, pageMaker: any[]): void {
    if (this.collecting) return;
    const item = this.targetLookupItems.get(anchorName);
    if (item && item.state === 'up-to-date') {
      item.pageMakerIndex = pageMakerIndex;
      if (JSON.stringify(item.cachedPageCounterValues) !== JSON.stringify(pageCounterValues)) {
        item.cachedPageCounterValues = JSON.parse(JSON.stringify(pageCounterValues));
        for (const m of this.counterLookupItems.values()) {
          const lookup = m.get('content');
          if (!lookup) continue;
          const missing = lookup.missingTargetCounters[anchorName];
          if (missing === undefined) continue;
          if (lookup.pageMakerIndex === null || lookup.pageMakerIndex >= pageMaker.length) {
            lookup.pending = true;
            continue;
          }
          for (const counterName of missing) {
            if (pageCounterValues[counterName] !== undefined) {
              const remakeState = pageMaker[lookup.pageMakerIndex][pageMaker[lookup.pageMakerIndex].length - 1];
              remakeState.contentChanged = true;
              lookup.parseAgain(new Map(Object.entries(lookup.cachedPageCounterValues)));
              break;
            }
          }
        }
      }
    }
  }
}