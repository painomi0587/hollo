import { Hono } from "hono";
import { trimTrailingSlash } from "hono/trailing-slash";

import accounts from "./accounts";
import auth from "./auth";
import emojis from "./emojis";
import federation from "./federation";
import home from "./home";
import login from "./login";
import logout from "./logout";
import profile from "./profile";
import setup from "./setup";
import tags from "./tags";
import thumbnail_cleanup from "./thumbnail_cleanup";

const page = new Hono();

page.use(trimTrailingSlash());
page.route("/", home);
page.route("/:handle{@[^/]+}", profile);
page.route("/login", login);
page.route("/logout", logout);
page.route("/setup", setup);
page.route("/auth", auth);
page.route("/accounts", accounts);
page.route("/emojis", emojis);
page.route("/federation", federation);
page.route("/thumbnail_cleanup", thumbnail_cleanup);
page.route("/tags", tags);

export default page;
