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
import stamp from "./stamp";
import watermark from "./watermark";
import pageNumbers from "./pageNumbers";
import headerFooter from "./headerFooter";
import bates from "./bates";
import sign from "./sign";
import encrypt from "./encrypt";
import unlock from "./unlock";
import sanitize from "./sanitize";
import metadata from "./metadata";
import removeMetadata from "./removeMetadata";
import editMetadata from "./editMetadata";

/** The English dictionary, bundled with the app. Add a namespace here, then in every locale. */
export const en = {
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
  stamp,
  watermark,
  pageNumbers,
  headerFooter,
  bates,
  sign,
  encrypt,
  unlock,
  sanitize,
  metadata,
  removeMetadata,
  editMetadata,
};

export type EnDictionary = typeof en;
export type NamespaceName = keyof EnDictionary;
