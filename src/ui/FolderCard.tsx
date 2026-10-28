import { FolderOpen } from "lucide-react";

type FolderCardProps = {
  name: string;
  items: number;
  tint: string;
  avatars?: string[];
};

export function FolderCard({ name, items, tint, avatars }: FolderCardProps) {
  return (
    <article className={`foldercard tint-${tint}`}>
      <span className="foldericon">
        <FolderOpen />
      </span>
      <h3>{name}</h3>
      {avatars && avatars.length > 0 && (
        <span className="avatars">
          {avatars.map((a, i) => (
            <i key={i}>{a}</i>
          ))}
        </span>
      )}
      <span className="items">{items} items</span>
    </article>
  );
}
