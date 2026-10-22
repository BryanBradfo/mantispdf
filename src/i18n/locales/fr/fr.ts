import type { Dictionary } from "../../types";
import type { EnDictionary } from "../en";
import common from "./common";
import compress from "./compress";
import crop from "./crop";
import extractImages from "./extractImages";
import extractPages from "./extractPages";
import geometry from "./geometry";
import home from "./home";
import imagesToPdf from "./imagesToPdf";
import merge from "./merge";
import nUp from "./nUp";
import organize from "./organize";
import pages from "./pages";
import pdfToImage from "./pdfToImage";
import removePages from "./removePages";
import resize from "./resize";
import rotate from "./rotate";
import seo from "./seo";
import split from "./split";

/** French, loaded as its own chunk when a `/fr` page is first rendered (or preloaded). */
const fr: Dictionary<EnDictionary> = {
  common,
  home,
  seo,
  pages,
  geometry,
  split,
  merge,
  compress,
  rotate,
  organize,
  removePages,
  extractPages,
  pdfToImage,
  imagesToPdf,
  extractImages,
  crop,
  resize,
  nUp,
};

export default fr;
