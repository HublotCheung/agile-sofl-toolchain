import {describe,it,expect} from 'vitest'
import {compactDiagnosticPayload} from './diagnosticPayload'
describe('model-facing diagnostic bounds',()=>{
 it('preserves real error counts and leaves raw objects intact',()=>{
  const raw={count:30,errors:30,items:Array.from({length:30},()=>({code:'ASFL_PARSE',severity:'error',line:4,column:8,message:'x'.repeat(675000)}))}
  const result=compactDiagnosticPayload(raw)
  expect(JSON.stringify(result).length).toBeLessThan(13000)
  expect(result.errors).toBe(30)
  expect(result.omittedItems).toBe(18)
  expect(result.truncated).toBe(true)
  expect(result.items[0].line).toBe(4)
  expect(raw.items[0].message.length).toBe(675000)
 })
 it('retains small diagnostics',()=>{
  const result=compactDiagnosticPayload({count:1,errors:1,items:[{code:'E',severity:'error',message:'expected expression'}]})
  expect(result.truncated).toBe(false)
  expect(result.items[0].message).toBe('expected expression')
 })
})
