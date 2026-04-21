import { Command } from "commander";
import { universeCommand } from "./src/cli/commands/universe";

const program = new Command();

program.name("kbaas").description("Kbaas is an AI Knowledge base creator");

program.addCommand(universeCommand);

await program.parseAsync();
