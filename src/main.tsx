import { createRoot } from "react-dom/client";
import "./styles/index.css";
import { Shell } from "./app/Shell";

document.documentElement.dataset.theme = "dark";

createRoot(document.getElementById("root")!).render(<Shell />);
