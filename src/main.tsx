import { createRoot } from "react-dom/client";
import "./styles/index.css";
import { Shell } from "./app/Shell";

createRoot(document.getElementById("root")!).render(<Shell />);
