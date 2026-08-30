import { describe, expect, it } from 'vitest';
import { mergeTranscriptItem } from '../hooks/useAssistant';
import { TranscriptItem } from '../types';

function item(id: string, text: string, sender: 'user' | 'sera' = 'sera', isPartial = false): TranscriptItem {
  return { id, text, sender, timestamp: Date.now(), isPartial };
}

describe('mergeTranscriptItem', () => {
  it('replaces a partial caption in place', () => {
    const previous = [item('one', 'hel', 'sera', true)];
    const result = mergeTranscriptItem(previous, item('two', 'hello', 'sera', true));

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'one', text: 'hello', sender: 'sera', isPartial: true });
  });

  it('finalizes a partial caption without creating a duplicate', () => {
    const previous = [item('one', 'hello wor', 'sera', true)];
    const result = mergeTranscriptItem(previous, item('two', 'hello world', 'sera', false));

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'one', text: 'hello world', sender: 'sera', isPartial: false });
  });

  it('starts a new entry when the speaker changes', () => {
    const previous = [item('one', 'hello', 'sera', true)];
    const result = mergeTranscriptItem(previous, item('two', 'hi', 'user', true));

    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({ id: 'two', sender: 'user', text: 'hi' });
  });

  it('ignores empty transcript events', () => {
    const previous = [item('one', 'hello')];
    expect(mergeTranscriptItem(previous, item('two', '   '))).toBe(previous);
  });

  it('concatenates streaming delta chunks from the same speaker into one cohesive message', () => {
    let list: TranscriptItem[] = [];
    list = mergeTranscriptItem(list, item('1', 'Well hello', 'sera'));
    list = mergeTranscriptItem(list, item('2', 'there.', 'sera'));
    list = mergeTranscriptItem(list, item('3', "What's", 'sera'));
    list = mergeTranscriptItem(list, item('4', 'happening?', 'sera'));

    expect(list).toHaveLength(1);
    expect(list[0].text).toBe("Well hello there. What's happening?");
    expect(list[0].sender).toBe('sera');
  });

  it('retains only the latest 30 finalized entries when a new turn starts', () => {
    const previous = Array.from({ length: 30 }, (_, index) => item(String(index), String(index), index % 2 === 0 ? 'user' : 'sera'));
    const result = mergeTranscriptItem(previous, item('new', 'new', 'user'));

    expect(result).toHaveLength(30);
    expect(result[0].id).toBe('1');
    expect(result[29].id).toBe('new');
  });
});


