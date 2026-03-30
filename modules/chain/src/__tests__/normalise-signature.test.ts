import { describe, it, expect } from 'vitest';
import { normaliseViewCallSignature } from '../rpc.js';

describe('normaliseViewCallSignature', () => {
  it('passes through a well-formed human-readable signature', () => {
    const sig = 'function balanceOf(address) view returns (uint256)';
    expect(normaliseViewCallSignature(sig)).toBe(sig);
  });

  it('prefixes "function" when missing', () => {
    expect(normaliseViewCallSignature('balanceOf(address) view returns (uint256)')).toBe(
      'function balanceOf(address) view returns (uint256)',
    );
  });

  it('strips "external" modifier from Solidity-style signature', () => {
    expect(
      normaliseViewCallSignature('getEntryQueueFlushSize() external view returns (uint256)'),
    ).toBe('function getEntryQueueFlushSize() view returns (uint256)');
  });

  it('strips "public" modifier', () => {
    expect(
      normaliseViewCallSignature('function totalSupply() public view returns (uint256)'),
    ).toBe('function totalSupply() view returns (uint256)');
  });

  it('handles bare function name with no modifiers', () => {
    expect(normaliseViewCallSignature('paused() returns (bool)')).toBe(
      'function paused() returns (bool)',
    );
  });
});
