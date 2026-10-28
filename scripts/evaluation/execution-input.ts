import { InputSchema, type EvalCase, type EvalInput } from './contracts.ts';
import { outputContractInstruction } from './output-format.ts';
import { reportContractInstruction } from './report-format.ts';

/** Disclose output requirements, never oracle answers, through the actual task input. */
export function buildExecutionInput(c:EvalCase):EvalInput{
  const input=structuredClone(c.input),contract=c.expected_final.outputContract;
  if(contract&&input.scenario.driver==='runtime'){
    input.scenario.outputContract=contract;
    input.scenario.instruction+='\n\n'+outputContractInstruction(contract);
  }
  if(c.expected_final.reportContract && input.scenario.driver === 'runtime') input.scenario.instruction += '\n\n' + reportContractInstruction(c.expected_final.reportContract);
  return InputSchema.parse(input);
}
