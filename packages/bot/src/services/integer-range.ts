export const MAX_DETERMINISTIC_RANGE_ITEMS = 1_000;

export interface IntegerRangeRequest {
  start: number;
  end: number;
  itemCount: number;
}

export interface IntegerRangeResponse extends IntegerRangeRequest {
  status: 'rendered' | 'too_large';
  content: string;
  renderedItemCount: number;
}

const INTEGER_RANGE_REQUEST =
  /^(?:please\s+)?(?:count|list)(?:\s+(?:all\s+)?(?:the\s+)?(?:whole\s+)?(?:integers?|numbers?))?(?:\s+(?:out|off))?\s+(?:from\s+)?(-?\d{1,9})\s*(?:-|–|—|to|through|thru)\s*(-?\d{1,9})(?:\s+(?:inclusive(?:ly)?|all\s+at\s+once|in\s+one\s+(?:go|message)))?(?:\s+please)?[.!?]*$/i;

export function parseIntegerRangeRequest(text: string): IntegerRangeRequest | null {
  const normalized = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const match = INTEGER_RANGE_REQUEST.exec(normalized);
  if (!match) {
    return null;
  }

  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    return null;
  }

  return {
    start,
    end,
    itemCount: Math.abs(end - start) + 1
  };
}

export function renderIntegerRangeResponse(
  request: IntegerRangeRequest,
  maxOutputCharacters: number
): IntegerRangeResponse {
  const safeCharacterLimit = Math.max(1, Math.trunc(maxOutputCharacters));
  if (request.itemCount > MAX_DETERMINISTIC_RANGE_ITEMS) {
    return buildTooLargeResponse(request);
  }

  const step = request.end >= request.start ? 1 : -1;
  const values = Array.from(
    { length: request.itemCount },
    (_, index) => request.start + index * step
  );
  const content = values.join(', ');

  if (content.length > safeCharacterLimit) {
    return buildTooLargeResponse(request);
  }

  return {
    ...request,
    status: 'rendered',
    content,
    renderedItemCount: request.itemCount
  };
}

function buildTooLargeResponse(request: IntegerRangeRequest): IntegerRangeResponse {
  return {
    ...request,
    status: 'too_large',
    content:
      "That full range won't fit in one Discord message. Ask for a smaller range so I can send every number without cutting anything off.",
    renderedItemCount: 0
  };
}
