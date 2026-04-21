import { Command } from "commander";
import { createUniverseCommand } from "./create";
import { deleteUniverseCommand } from "./delete";
import { getUniverseCommand } from "./get";
import { loadFileUniverseCommand } from "./load-file";
import { listUniverseCommand } from "./list";

export const universeCommand = new Command("universe")
  .description("Manage universes")
  .addCommand(createUniverseCommand)
  .addCommand(listUniverseCommand)
  .addCommand(getUniverseCommand)
  .addCommand(loadFileUniverseCommand)
  .addCommand(deleteUniverseCommand);
