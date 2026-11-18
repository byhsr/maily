import { pageText } from "../lib/followups";
import { Button } from "./Button";

/** Moving through a list the page is already holding: what is on screen, and the two buttons
 *  that move it. One page either side of the current one, because the lists here are short
 *  enough to read rather than to search. */
export function Pager({
  offset,
  size,
  total,
  onPage,
}: {
  offset: number;
  size: number;
  total: number;
  onPage: (offset: number) => void;
}) {
  if (total <= size) {
    return <p className="muted statnote">{pageText(offset, size, total)}</p>;
  }
  return (
    <div className="pager">
      <span className="muted">{pageText(offset, size, total)}</span>
      <Button
        variant="ghost"
        type="button"
        disabled={offset <= 0}
        onClick={() => onPage(Math.max(0, offset - size))}
      >
        Previous
      </Button>
      <Button
        variant="ghost"
        type="button"
        disabled={offset + size >= total}
        onClick={() => onPage(offset + size)}
      >
        Next
      </Button>
    </div>
  );
}
