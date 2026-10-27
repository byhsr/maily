import { createRoot } from "react-dom/client";
import "./styles/index.css";
import { Shell } from "./app/Shell";

document.documentElement.dataset.theme = localStorage.mailyTheme === "light" ? "light" : "dark";

createRoot(document.getElementById("root")!).render(<Shell />);
