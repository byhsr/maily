export function HeroNumber({ value }: { value: number }) {
  return <div className="heronum">{value.toLocaleString()}</div>;
}
