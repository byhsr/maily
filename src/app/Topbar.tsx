import { Plus } from "lucide-react";
import { Button } from "../ui/Button";
import { FilterChip } from "../ui/FilterChip";

export const STATUS_FILTERS = ["All", "Active", "Draft", "Paused"];

type TopbarProps = {
  page: string;
  status: string;
  onStatus: (status: string) => void;
  onNewCampaign: () => void;
};

export function Topbar({ page, status, onStatus, onNewCampaign }: TopbarProps) {
  return (
    <>
      <header className="newhead">
        <div>
          <label>OUTREACH STUDIO</label>
          <h1>{page === "Home" ? <>Make every <em>hello</em> count.</> : page === "Canvas" ? "Campaign canvas" : page}</h1>
        </div>
        <div className="headtools">
          <Button onClick={onNewCampaign}>
            <Plus />New campaign
          </Button>
        </div>
      </header>
      <div className="chips">
        {STATUS_FILTERS.map((s) => (
          <FilterChip key={s} label={s} active={status === s} onClick={() => onStatus(s)} />
        ))}
      </div>
    </>
  );
}
