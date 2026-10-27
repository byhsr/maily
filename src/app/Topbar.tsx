type TopbarProps = {
  page: string;
};

export function Topbar({ page }: TopbarProps) {
  return (
    <header className="newhead">
      <div>
        <label>OUTREACH STUDIO</label>
        <h1>{page === "Home" ? <>Make every <em>hello</em> count.</> : page}</h1>
      </div>
    </header>
  );
}
