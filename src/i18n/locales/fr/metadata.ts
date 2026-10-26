import type { Messages } from "../../types";
import type en from "../en/metadata";

const metadata: Messages<typeof en> = {
  title: "Titre",
  author: "Auteur",
  subject: "Sujet",
  keywords: "Mots-clés",
  empty: "(vide)",
};

export default metadata;
