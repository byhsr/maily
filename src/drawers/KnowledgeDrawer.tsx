import { useEffect, useState } from "react";
import { deleteKnowledge, previewKnowledge, saveKnowledge } from "../lib/api";
import { categoryMeta, KNOWLEDGE_CATEGORIES } from "../lib/knowledge";
import type { KnowledgeCategory, KnowledgeEntry } from "../lib/types";
import { Button } from "../ui/Button";
import { Checkbox } from "../ui/Checkbox";
import { Confirm } from "../ui/Confirm";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";

type KnowledgeDrawerProps = {
  close: () => void;
  entry?: KnowledgeEntry;
  reload: () => void;
  tell: (message: string) => void;
};

export function KnowledgeDrawer({ close, entry, reload, tell }: KnowledgeDrawerProps) {
  const [category, setCategory] = useState<KnowledgeCategory>(entry?.category ?? "offer");
  const [title, setTitle] = useState(entry?.title ?? "");
  const [content, setContent] = useState(entry?.content ?? "");
  const [tags, setTags] = useState((entry?.tags ?? []).join(", "));
  const [approved, setApproved] = useState(entry?.approved ?? false);
  const [block, setBlock] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    previewKnowledge()
      .then(setBlock)
      .catch(() => setBlock(""));
  }, [entry]);

  const save = async () => {
    if (!title.trim() || !content.trim()) {
      tell("A title and some content are required");
      return;
    }
    setBusy(true);
    try {
      await saveKnowledge({
        id: entry?.id ?? null,
        category,
        title,
        content,
        approved,
        tags: tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      });
      reload();
      tell(entry ? (approved ? "Entry updated and in prompts" : "Entry updated, not used yet") : "Entry added");
      close();
    } catch (e) {
      tell(String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!entry) return;
    setBusy(true);
    try {
      await deleteKnowledge(entry.id);
      reload();
      tell("Entry deleted");
      close();
    } catch (e) {
      tell(String(e));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <div className="drawerform">
      <p>{categoryMeta(category).hint}</p>
      <label>
        Category
        <Select
          label="Category"
          value={category}
          options={KNOWLEDGE_CATEGORIES.map((item) => ({ value: item.id, label: item.label }))}
          onChange={(value) => setCategory(value as KnowledgeCategory)}
        />
      </label>
      <label>
        Title
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What this entry is about" />
      </label>
      <label>
        Content
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Write it the way you would explain it to a new colleague."
        />
      </label>
      <label>
        Tags
        <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="saas, series-a (comma separated)" />
      </label>

      <div className="knowtoggle">
        <Checkbox checked={approved} onChange={setApproved} label="Use in prompts" />
        <span>
          <b>Use in prompts</b>
          <small>
            {approved
              ? "Approved entries are sent to the models that are scoped to this category."
              : "Unapproved entries are stored but never sent to a model."}
          </small>
        </span>
      </div>

      <div className="settingsrow">
        <Button variant="ink" onClick={save} disabled={busy}>
          {busy ? "Saving…" : entry ? "Save changes" : "Add entry"}
        </Button>
        {entry && (
          <Button variant="ghost" onClick={() => setConfirming(true)} disabled={busy}>
            Delete
          </Button>
        )}
      </div>

      {approved && (
        <>
          <h3>Prompt block</h3>
          <pre className="promptpreview">{block || "No approved entries yet."}</pre>
          <small>Exactly what a model receives today, budgeted to 6000 characters.</small>
        </>
      )}

      {confirming && (
        <Confirm
          title="Delete this entry?"
          message="Models will stop seeing it in their prompts."
          onConfirm={remove}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
