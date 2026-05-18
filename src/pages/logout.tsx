import { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import { csrf } from "hono/csrf";

const logout = new Hono();

logout.use(csrf());

logout.post("/", async (c) => {
  await deleteCookie(c, "login");
  return c.redirect("/");
});

export default logout;
