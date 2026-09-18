import { Router } from "express";
import type { EventService } from "../services/event-service.js";

export function createEventsRouter(eventService: EventService): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    const { limit, offset, defense, result, collapse } = _req.query;
    const data = eventService.getEvents({
      limit: limit ? parseInt(String(limit), 10) : undefined,
      offset: offset ? parseInt(String(offset), 10) : undefined,
      defense: defense ? String(defense) : undefined,
      result: result ? String(result) : undefined,
      collapse: collapse === "true",
    });
    res.json({ ok: true, data });
  });

  return router;
}
