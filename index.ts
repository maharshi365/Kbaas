import { Command } from "commander";
import { universeCommand } from "./src/cli/commands/universe";
import { loadKbaasConfig } from "./src/config/kbaas";

const program = new Command();

loadKbaasConfig();

program.name("kbaas").description("Kbaas is an AI Knowledge base creator");

program.addCommand(universeCommand);

await program.parseAsync();
